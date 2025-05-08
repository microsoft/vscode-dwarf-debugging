use std::collections::{HashMap, VecDeque};

enum Animal {
    Dog(String, f64),
    Cat { name: String, weight: f64 },
}

#[derive(Debug)]
#[allow(dead_code)]
struct Point2D {
    x: i32,
    y: i32,
}

fn print_animal_info(animal: Animal) {
    match animal {
        Animal::Dog(name, weight) => {
            println!("Dog's name: {}, weight: {} kg", name, weight);
        }
        Animal::Cat { name, weight } => {
            println!("Cat's name: {}, weight: {} kg", name, weight);
        }
    }
}

fn main() {
    let a: Animal = Animal::Dog("Biscuit".to_string(), 8.51);
    let b: Animal = Animal::Cat {
        name: "Whiskers".to_string(),
        weight: 3.15,
    };

    print_animal_info(a);
    print_animal_info(b);

    let hash_map = HashMap::from([(1, "One"), (2, "Two")]);
    let vector = Vec::from([1, 2, 3, 4, 5]);
    let mut vec_deque = VecDeque::from([1, 2, 3, 4, 5]);
    let vector_slice = &vector[1..3];
    let string_slice = &"Biscuit".to_string()[2..5];

    vec_deque.pop_front();
    vec_deque.pop_front();
    vec_deque.pop_front();
    vec_deque.push_back(1);
    vec_deque.push_back(2);

    println!("hash_map: {:?}", hash_map);
    println!("vector: {:?}", vector);
    println!("vec_deque: {:?}", vec_deque);
    println!("vector_slice: {:?}", vector_slice);
    println!("string_slice: {:?}", string_slice);

    let strong_ref = std::rc::Rc::new(Point2D { x: 20, y: 40 });
    let weak_ref_1 = std::rc::Rc::downgrade(&strong_ref);
    let weak_ref_2 = std::rc::Rc::downgrade(&strong_ref);

    println!("rc pointers:");
    println!("  strong_ref: {:?}", strong_ref);
    println!("  weak_ref_1: {:?}", weak_ref_1.upgrade());
    println!("  weak_ref_2: {:?}", weak_ref_2.upgrade());
    println!("  strong_count: {}", weak_ref_2.strong_count());
    println!("  weak_count: {}", weak_ref_2.weak_count());

    drop(weak_ref_1);
    println!("after drop weak_ref_1:");
    println!("  strong_ref: {:?}", strong_ref);
    println!("  weak_ref_2: {:?}", weak_ref_2.upgrade());
    println!("  strong_count: {}", weak_ref_2.strong_count());
    println!("  weak_count: {}", weak_ref_2.weak_count());

    drop(strong_ref);
    println!("after drop weak_ref_1:");
    println!("  weak_ref_2: {:?}", weak_ref_2.upgrade());
    println!("  strong_count: {}", weak_ref_2.strong_count());
    println!("  weak_count: {}", weak_ref_2.weak_count());
}
